// const {UserModel1} = require('../models/userModel');
const Sequelize = require('sequelize');
const { sequelize } = require('../servicenow-models/sequelize');
const initModels = require('../servicenow-models/init-models');
const models = initModels(sequelize);
const Op = require('sequelize').Op;


async function saveUserInfo(userObj){
    try {
        // console.log(userObj);
        let id = userObj.id;
        const existingUser = await models.customer.findOne({
            where: {
                [Op.and]: [
                    {
                        id,
                        // platform
                    }
                ]
            }
        });
        if (existingUser) {
            console.log('Existing user update');
            // const updateUser = await UserModel1.update({

            // })
        }
        else {
            console.log('This is userobj',userObj);
            const createUser = await models.customer.create({
                sys_id: userObj.id, 
                firstname: userObj.first_name, 
                lastname: userObj.last_name,
                email: userObj.email,
                company_id: 1,
                hostname:process.env.hostname
            })
            console.log(createUser);
        }    
    } catch (error) {
        console.log(error);
        return error
    }
}

exports.saveUserInfo = saveUserInfo;